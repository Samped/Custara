{
    "name": "Custara AP",
    "summary": "Send vendor bills to Custara for approval and Arc mainnet USDC settlement. Odoo stays the ledger.",
    "version": "18.0.1.0.2",
    "category": "Accounting/Accounting",
    "author": "Custara",
    "website": "https://custara.xyz",
    "license": "LGPL-3",
    "depends": ["account"],
    "data": [
        "views/res_config_settings.xml",
        "views/account_move.xml",
    ],
    "images": [
        "static/description/main_screenshot.png",
        "static/description/screen_login.png",
        "static/description/screen_connect.png",
        "static/description/screen_odoo_settings.png",
        "static/description/screen_odoo_send.png",
        "static/description/screen_controls.png",
        "static/description/screen_pay.png",
    ],
    "installable": True,
    "application": False,
    "description": """
Custara is the AP control plane. Odoo stays the ledger.

Approved bills settle in Arc mainnet USDC on https://custara.xyz.
Use https://testnet.custara.xyz only for demos.

Install, set the Custara API URL and Partner API key under Settings → Accounting,
then use Send to Custara on a vendor bill or credit.
""",
}
