/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/search", "N/record", "N/task"], (search, record, task) => {
  const MAX = 1000, first = v => Array.isArray(v) ? v[0] || "" : v || "";
  const runSearch = (type, filters, columns, fn) => { const r = []; search.create({ type, filters, columns }).run().each(x => r.length < MAX ? (r.push(fn(x)), true) : false); return r; };

  const getHandlers = {
    employees: () => runSearch("employee", [["isinactive", "is", "F"]], ["internalid", "firstname", "lastname", "email"],
      r => ({ id: r.getValue("internalid"), name: `${r.getValue("firstname") || ""} ${r.getValue("lastname") || ""}`.trim() || r.getValue("email") || r.getValue("internalid"), email: r.getValue("email") || "" })),

    locations: () => runSearch("location", [["isinactive", "is", "F"]], ["internalid", "name"], r => ({ id: r.getValue("internalid"), name: r.getValue("name") })),

    vendors: ({ q }) => q?.length >= 2 ? runSearch("vendor", [["isinactive", "is", "F"], "AND", ["entityid", "contains", q]], ["internalid", "entityid"],
      r => ({ id: r.getValue("internalid"), name: r.getValue("entityid"), code: r.getValue("entityid") })) : [],

    items: ({ q }) => q?.length >= 2 ? runSearch("noninventoryitem", [["isinactive", "is", "F"], "AND", [["itemid", "contains", q], "OR", ["displayname", "contains", q]]], ["internalid", "itemid", "displayname", "description"],
      r => ({ id: r.getValue("internalid"), name: r.getValue("displayname") || r.getValue("itemid"), sku: r.getValue("itemid"), description: r.getValue("description") || "" })) : [],

    itemVendors: ({ itemId }) => {
      if (!itemId) throw new Error("itemId required");
      const rec = record.load({ type: "noninventoryitem", id: itemId, isDynamic: false }), n = rec.getLineCount({ sublistId: "itemvendor" });
      return [...Array(n)].map((_, i) => ({ id: rec.getSublistValue({ sublistId: "itemvendor", fieldId: "vendor", line: i }), name: rec.getSublistText({ sublistId: "itemvendor", fieldId: "vendor", line: i }), purchasePrice: Number(rec.getSublistValue({ sublistId: "itemvendor", fieldId: "purchaseprice", line: i }) || 0) }));
    },

    requests: ({ employeeId }) => {
      if (!employeeId) throw new Error("employeeId required");
      const d = new Date(); d.setMonth(d.getMonth() - 2);
      const reqs = runSearch("purchaserequisition", [["mainline", "is", "T"], "AND", ["entity", "anyof", employeeId], "AND", ["trandate", "onorafter", `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`]],
        ["internalid", "trandate", "tranid"], r => ({ id: r.getValue("internalid"), tranDate: r.getValue("trandate"), tranId: r.getValue("tranid") }));
      if (!reqs.length) return [];

      const vendorIds = new Set(), lineData = reqs.flatMap(req => {
        const rec = record.load({ type: "purchaserequisition", id: req.id, isDynamic: false }), n = rec.getLineCount({ sublistId: "item" });
        return [...Array(n)].map((_, i) => {
          const vid = rec.getSublistValue({ sublistId: "item", fieldId: "povendor", line: i }); vid && vendorIds.add(vid);
          const [day, mon] = (req.tranDate || "").split("/");
          return { tranDate: day && mon ? `${day}/${mon}` : "", tranId: req.tranId, itemName: rec.getSublistText({ sublistId: "item", fieldId: "item", line: i }), vendorId: vid || "", vendorName: "", poNumber: first(rec.getSublistText({ sublistId: "item", fieldId: "linkedorder", line: i })) };
        });
      });

      if (vendorIds.size) {
        const vmap = {}; runSearch("vendor", [["internalid", "anyof", [...vendorIds]]], ["internalid", "companyname", "entityid"], r => { vmap[r.getValue("internalid")] = r.getValue("companyname") || r.getValue("entityid") || ""; return null; });
        lineData.forEach(l => l.vendorId && (l.vendorName = vmap[l.vendorId] || ""));
      }
      return lineData;
    }
  };

  const addVendorToItem = (itemId, vendorId, price) => {
    const rec = record.load({ type: "noninventoryitem", id: itemId, isDynamic: true }), n = rec.getLineCount({ sublistId: "itemvendor" });
    for (let i = 0; i < n; i++) if (String(rec.getSublistValue({ sublistId: "itemvendor", fieldId: "vendor", line: i })) === String(vendorId)) return;
    rec.selectNewLine({ sublistId: "itemvendor" }); rec.setCurrentSublistValue({ sublistId: "itemvendor", fieldId: "vendor", value: vendorId });
    price && rec.setCurrentSublistValue({ sublistId: "itemvendor", fieldId: "purchaseprice", value: price });
    rec.commitLine({ sublistId: "itemvendor" }); rec.save({ ignoreMandatoryFields: true });
  };

  const createRequisition = ({ requestorId, subsidiary, location, items }) => {
    if (!requestorId || !subsidiary || !items?.length) throw new Error("requestorId, subsidiary, items required");
    items.filter(i => i.isNewVendor && i.vendorId && i.itemId).forEach(i => addVendorToItem(i.itemId, i.vendorId, i.estimatedPrice));

    const req = record.create({ type: "purchaserequisition", isDynamic: false });
    [["entity", requestorId], ["subsidiary", subsidiary], ["location", location]].forEach(([f, v]) => v && req.setValue({ fieldId: f, value: v }));

    items.forEach(({ itemId, quantity, estimatedPrice, description, vendorId }, idx) => [["item", itemId], ["quantity", quantity || 1], ["rate", estimatedPrice], ["description", description], ["povendor", vendorId], ["location", location]]
      .forEach(([f, v]) => v && req.setSublistValue({ sublistId: "item", fieldId: f, line: idx, value: v })));

    const id = req.save({ enableSourcing: false, ignoreMandatoryFields: true });
    task.create({ taskType: task.TaskType.WORKFLOW_TRIGGER, workflowId: "949", recordType: "purchaserequisition", recordId: id }).submit();
    return { id, tranId: search.lookupFields({ type: "purchaserequisition", id, columns: "tranid" }).tranid };
  };

  return { get: p => getHandlers[p.action]?.(p) ?? (() => { throw new Error("Unknown action"); })(), post: b => b?.action === "createRequisition" ? createRequisition(b) : (() => { throw new Error("Action required"); })() };
});
