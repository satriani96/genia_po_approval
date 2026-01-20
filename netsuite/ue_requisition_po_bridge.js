/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {
    return {
        afterSubmit: (context) => {
            if (context.type !== context.UserEventType.CREATE) return;

            try {
                // Use submitFields to create a "State Change" update.
                // This triggers the workflow via the User Event context.
                record.submitFields({
                    type: 'purchaserequisition',
                    id: context.newRecord.id,
                    values: {
                        'custbody_altas_anz_so_po_notes': `Bridge Trigger: ${new Date().getTime()}`
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.audit({ title: 'BRIDGE_POKE_SUCCESS', details: `Requisition ${context.newRecord.id} poked.` });
            } catch (e) {
                log.error({ title: 'BRIDGE_POKE_FAILED', details: e });
            }
        }
    };
});