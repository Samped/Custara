app_name = "custara_ap"
app_title = "Custara AP"
app_publisher = "Custara"
app_description = "Send ERPNext Purchase Invoices to Custara for approval and Arc USDC settlement. ERPNext stays the ledger."
app_email = "hello@custara.xyz"
app_license = "MIT"
app_version = "1.0.0"
app_home = "/app/custara-settings"
app_logo_url = "/assets/custara_ap/images/logo.png"

required_apps = ["erpnext"]

doctype_js = {
    "Purchase Invoice": "public/js/purchase_invoice.js",
}

doc_events = {
    "Purchase Invoice": {
        "on_submit": "custara_ap.purchase_invoice.on_submit",
    },
}
