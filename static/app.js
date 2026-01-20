// DOM
const employeeInput = document.getElementById("employee-input");
const employeeDropdown = document.getElementById("employee-dropdown");
const employeeIdHidden = document.getElementById("employee-id");
const locationSelect = document.getElementById("location-select");
const locationIdHidden = document.getElementById("location-id");
const requestorIdInput = document.getElementById("requestor-id");
const requisitionForm = document.getElementById("requisition-form");
const itemsContainer = document.getElementById("items-container");
const addItemButton = document.getElementById("add-item");
const refreshBtn = document.getElementById("refresh-requests");

// Storage
const STORAGE_KEY = "genia.employeeId";
const STORAGE_NAME_KEY = "genia.employeeName";
const STORAGE_LOCATION_KEY = "genia.locationId";

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  remove(k) { try { localStorage.removeItem(k); } catch {} }
};

// Employee
let allEmployees = [];

function setEmployee(id, name) {
  if (id) {
    storage.set(STORAGE_KEY, id);
    storage.set(STORAGE_NAME_KEY, name || "");
  } else {
    storage.remove(STORAGE_KEY);
    storage.remove(STORAGE_NAME_KEY);
  }
  if (employeeIdHidden) employeeIdHidden.value = id || "";
  if (requestorIdInput) requestorIdInput.value = id || "";
  if (employeeInput && name) employeeInput.value = name;
}

async function loadEmployees() {
  try {
    const res = await fetch("/api/employees");
    if (!res.ok) throw new Error("Failed to load");
    allEmployees = await res.json();
    buildDropdown(allEmployees);

    // Restore saved selection
    const savedId = storage.get(STORAGE_KEY);
    const savedName = storage.get(STORAGE_NAME_KEY);
    if (savedId && savedName) {
      setEmployee(savedId, savedName);
    }
  } catch (err) {
    console.error("Employee load error:", err);
    if (employeeInput) employeeInput.placeholder = "Error loading employees";
  }
}

// Location
const EXCLUDED_LOCATION_IDS = ["8"]; // Offsite

async function loadLocations() {
  if (!locationSelect) return;
  try {
    const res = await fetch("/api/locations");
    if (!res.ok) throw new Error("Failed to load");
    const locations = await res.json();
    
    locationSelect.innerHTML = '<option value="">Select location...</option>';
    locations
      .filter(loc => !EXCLUDED_LOCATION_IDS.includes(String(loc.id)))
      .forEach(loc => {
        const opt = document.createElement("option");
        opt.value = loc.id;
        opt.textContent = loc.name;
        locationSelect.appendChild(opt);
      });

    // Restore saved selection
    const savedLocation = storage.get(STORAGE_LOCATION_KEY);
    if (savedLocation) {
      locationSelect.value = savedLocation;
      if (locationIdHidden) locationIdHidden.value = savedLocation;
    }
  } catch (err) {
    console.error("Location load error:", err);
  }
}

function setLocation(id) {
  if (id) {
    storage.set(STORAGE_LOCATION_KEY, id);
  } else {
    storage.remove(STORAGE_LOCATION_KEY);
  }
  if (locationIdHidden) locationIdHidden.value = id || "";
}

function buildDropdown(employees) {
  if (!employeeDropdown) return;
  employeeDropdown.innerHTML = "";
  employees.forEach(emp => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "employee-option";
    btn.textContent = emp.name || emp.email || emp.id;
    btn.dataset.id = emp.id;
    btn.dataset.name = emp.name || emp.email || emp.id;
    btn.addEventListener("click", () => {
      setEmployee(emp.id, btn.dataset.name);
      closeDropdown();
      refreshRequests();
    });
    employeeDropdown.appendChild(btn);
  });
}

function filterDropdown(query) {
  if (!employeeDropdown) return;
  const q = query.toLowerCase();
  const options = employeeDropdown.querySelectorAll(".employee-option");
  options.forEach(opt => {
    const name = (opt.dataset.name || "").toLowerCase();
    opt.classList.toggle("hidden", q && !name.includes(q));
  });
}

function openDropdown() {
  if (employeeDropdown) employeeDropdown.classList.add("open");
}

function closeDropdown() {
  if (employeeDropdown) employeeDropdown.classList.remove("open");
}

if (employeeInput) {
  employeeInput.addEventListener("focus", () => {
    filterDropdown(employeeInput.value);
    openDropdown();
  });

  employeeInput.addEventListener("input", () => {
    filterDropdown(employeeInput.value);
    openDropdown();
  });

  document.addEventListener("click", e => {
    if (!employeeInput.contains(e.target) && !employeeDropdown?.contains(e.target)) {
      closeDropdown();
    }
  });
}

// Debounce
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Item search
async function searchItems(q) {
  try {
    const res = await fetch(`/api/items?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function loadItemVendors(itemId) {
  try {
    const res = await fetch(`/api/item-vendors?itemId=${encodeURIComponent(itemId)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function searchVendors(q) {
  try {
    const res = await fetch(`/api/vendors?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

// Vendor Modal
const vendorModal = document.getElementById("vendor-modal");
const vendorModalClose = document.getElementById("vendor-modal-close");
const vendorSearchInput = document.getElementById("vendor-search-input");
const vendorSearchResults = document.getElementById("vendor-search-results");

function openVendorModal() {
  if (!vendorModal) return;
  vendorModal.classList.add("open");
  if (vendorSearchInput) {
    vendorSearchInput.value = "";
    vendorSearchInput.focus();
  }
  if (vendorSearchResults) {
    vendorSearchResults.innerHTML = '<div class="modal-empty">Type to search vendors</div>';
  }
}

function closeVendorModal() {
  if (!vendorModal) return;
  vendorModal.classList.remove("open");
  activeVendorRow = null;
}

function selectVendorFromModal(vendor) {
  if (!activeVendorRow) return;
  
  const vendorSelect = activeVendorRow.querySelector(".vendor-select");
  
  // Add this vendor as a new option and select it
  const opt = document.createElement("option");
  opt.value = vendor.id;
  opt.textContent = vendor.name;
  opt.dataset.price = "";
  opt.selected = true;
  
  // Insert before "More Vendors" option
  const moreOpt = vendorSelect.querySelector('option[value="__more__"]');
  if (moreOpt) {
    vendorSelect.insertBefore(opt, moreOpt);
  } else {
    vendorSelect.appendChild(opt);
  }
  
  // Mark as new vendor
  activeVendorRow.dataset.isNewVendor = "true";
  
  closeVendorModal();
}

if (vendorModalClose) {
  vendorModalClose.addEventListener("click", closeVendorModal);
}

if (vendorModal) {
  vendorModal.addEventListener("click", (e) => {
    if (e.target === vendorModal) closeVendorModal();
  });
}

if (vendorSearchInput) {
  const doVendorSearch = debounce(async () => {
    const q = vendorSearchInput.value.trim();
    if (q.length < 2) {
      vendorSearchResults.innerHTML = '<div class="modal-empty">Type to search vendors</div>';
      return;
    }
    
    vendorSearchResults.innerHTML = '<div class="modal-empty">Searching...</div>';
    const vendors = await searchVendors(q);
    
    if (!vendors.length) {
      vendorSearchResults.innerHTML = '<div class="modal-empty">No vendors found</div>';
      return;
    }
    
    vendorSearchResults.innerHTML = "";
    vendors.forEach(v => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "modal-result";
      btn.innerHTML = `<div class="modal-result-name">${v.name}</div>
        <div class="modal-result-code">${v.code || ""}</div>`;
      btn.onclick = () => selectVendorFromModal(v);
      vendorSearchResults.appendChild(btn);
    });
  }, 200);
  
  vendorSearchInput.addEventListener("input", doVendorSearch);
}

function renderResults(container, items, onSelect) {
  container.innerHTML = "";
  if (!items.length) {
    container.classList.remove("visible");
    return;
  }
  container.classList.add("visible");
  items.forEach(item => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-result";
    btn.innerHTML = `<div class="search-result-name">${item.name}</div>
      <div class="search-result-desc">${item.description || item.sku || ""}</div>`;
    btn.onclick = () => onSelect(item);
    container.appendChild(btn);
  });
}

// Vendor modal state
let activeVendorRow = null;

function setupItemRow(row) {
  const searchInput = row.querySelector(".item-search");
  const itemIdInput = row.querySelector(".item-id");
  const results = row.querySelector(".item-results");
  const vendorSelect = row.querySelector(".vendor-select");
  const priceInput = row.querySelector(".estimated-price");
  const qtyInput = row.querySelector(".quantity");
  const notesInput = row.querySelector(".line-notes");
  const removeBtn = row.querySelector(".remove-item");

  if (!qtyInput.value) qtyInput.value = "1";

  // Track if vendor is new (from "More Vendors")
  row.dataset.isNewVendor = "false";

  const populateVendorDropdown = (vendors) => {
    vendorSelect.innerHTML = '<option value="">Select vendor</option>';
    vendors.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      opt.dataset.price = v.purchasePrice || "";
      vendorSelect.appendChild(opt);
    });
    // Add "More Vendors" option
    const moreOpt = document.createElement("option");
    moreOpt.value = "__more__";
    moreOpt.textContent = "── More Vendors ──";
    vendorSelect.appendChild(moreOpt);
  };

  const doSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      results.classList.remove("visible");
      return;
    }
    const items = await searchItems(q);
    renderResults(results, items, async (item) => {
      searchInput.value = item.name;
      itemIdInput.value = item.id;
      results.classList.remove("visible");
      row.dataset.isNewVendor = "false";

      // Pre-fetch vendors immediately
      const vendors = await loadItemVendors(item.id);
      populateVendorDropdown(vendors);
    });
  }, 200);

  searchInput.addEventListener("input", doSearch);
  searchInput.addEventListener("focus", doSearch);

  document.addEventListener("click", e => {
    if (!row.contains(e.target)) results.classList.remove("visible");
  });

  vendorSelect.addEventListener("change", () => {
    const val = vendorSelect.value;
    if (val === "__more__") {
      // Reset selection and open modal
      vendorSelect.value = "";
      activeVendorRow = row;
      openVendorModal();
      return;
    }
    const opt = vendorSelect.options[vendorSelect.selectedIndex];
    if (opt?.dataset.price && !priceInput.value) {
      priceInput.value = opt.dataset.price;
    }
    // Reset isNewVendor when selecting from existing list
    row.dataset.isNewVendor = "false";
  });

  removeBtn.addEventListener("click", () => row.remove());

  row._getData = () => ({
    itemId: itemIdInput.value,
    vendorId: vendorSelect.value === "__more__" ? "" : vendorSelect.value,
    isNewVendor: row.dataset.isNewVendor === "true",
    quantity: Number(qtyInput.value) || 1,
    estimatedPrice: Number(priceInput.value) || 0,
    description: notesInput.value.trim()
  });
}

function addItemRow() {
  if (!itemsContainer) return;
  const tpl = document.getElementById("item-row-template");
  if (!tpl) return;
  const clone = tpl.content.cloneNode(true);
  const row = clone.querySelector(".item-row");
  setupItemRow(row);
  itemsContainer.appendChild(row);
}

function collectItems() {
  if (!itemsContainer) return [];
  return Array.from(itemsContainer.querySelectorAll(".item-row"))
    .map(r => r._getData?.())
    .filter(i => i?.itemId);
}

// Requests
function refreshRequests() {
  const list = document.getElementById("requests-list");
  const id = employeeIdHidden?.value;
  if (!list || !id) return;
  
  // Show loading state
  list.innerHTML = '<div class="requests-loading"><div class="spinner"></div><span>Loading requests...</span></div>';
  if (refreshBtn) refreshBtn.classList.add("loading");
  
  htmx.ajax("GET", `/api/requests?employeeId=${encodeURIComponent(id)}`, {
    target: "#requests-list",
    swap: "innerHTML"
  }).then(() => {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }).catch(() => {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  });
}

// Form
if (addItemButton) {
  addItemButton.addEventListener("click", addItemRow);
}

if (requisitionForm) {
  const submitBtn = requisitionForm.querySelector('button[type="submit"]');

  requisitionForm.addEventListener("htmx:configRequest", e => {
    const empId = employeeIdHidden?.value;
    if (!empId) {
      e.preventDefault();
      showToast("Please select your name first.", "error");
      return;
    }
    const locId = locationIdHidden?.value;
    if (!locId) {
      e.preventDefault();
      showToast("Please select your location.", "error");
      return;
    }
    const items = collectItems();
    if (!items.length) {
      e.preventDefault();
      showToast("Please add at least one item.", "error");
      return;
    }
    e.detail.parameters.itemsJson = JSON.stringify(items);
    e.detail.parameters.requestorId = empId;
    e.detail.parameters.location = locId;
    setLoading(submitBtn, true);
  });

  requisitionForm.addEventListener("htmx:afterRequest", e => {
    setLoading(submitBtn, false);
    if (e.detail.xhr.status === 200) {
      // Extract REQ number from response HTML
      const responseText = e.detail.xhr.responseText || "";
      const match = responseText.match(/Requisition\s+(REQ\d+)/i);
      const reqNumber = match ? match[1] : null;
      
      showToast(reqNumber ? `${reqNumber} created!` : "Request submitted!", "success");
      
      // Clear form after success
      requisitionForm.reset();
      if (itemsContainer) {
        itemsContainer.innerHTML = "";
        addItemRow();
      }
      // Clear the status area
      const statusEl = document.getElementById("form-status");
      if (statusEl) statusEl.innerHTML = "";
    } else {
      showToast("Failed to submit request. Please try again.", "error");
    }
  });
}

function showStatus(msg, isError) {
  const el = document.getElementById("form-status");
  if (!el) return;
  el.innerHTML = `<div class="status ${isError ? 'status-error' : 'status-success'}">${msg}</div>`;
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add("loading");
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Submitting...";
  } else {
    btn.classList.remove("loading");
    if (btn.dataset.originalText) {
      btn.textContent = btn.dataset.originalText;
    }
  }
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", refreshRequests);
}

// Location change
if (locationSelect) {
  locationSelect.addEventListener("change", () => {
    setLocation(locationSelect.value);
  });
}

// Init
document.addEventListener("DOMContentLoaded", async () => {
  // Show loading state immediately on requests page
  if (window.location.pathname === "/requests") {
    const list = document.getElementById("requests-list");
    if (list) list.innerHTML = '<div class="requests-loading"><div class="spinner"></div><span>Loading...</span></div>';
  }
  
  // Load data in parallel and wait for completion
  await Promise.all([loadEmployees(), loadLocations()]);
  
  if (itemsContainer) addItemRow();
  if (window.location.pathname === "/requests") {
    refreshRequests();
  }
});
