frappe.ui.form.on("Purchase Invoice", {
  refresh(frm) {
    if (frm.doc.docstatus !== 1) return;
    frm.add_custom_button(__("Send to Custara"), () => {
      frappe.call({
        method: "custara_ap.purchase_invoice.send_to_custara",
        args: { name: frm.doc.name },
        freeze: true,
        freeze_message: __("Sending to Custara…"),
        callback(r) {
          if (!r.exc) {
            frappe.show_alert({
              message: __("Sent to Custara"),
              indicator: "green",
            });
            frm.reload_doc();
          }
        },
      });
    });
  },
});
