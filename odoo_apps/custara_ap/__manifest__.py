{
    "name": "Custara AP",
    "summary": "Send vendor bills to Custara for approval and Arc testnet USDC settlement. Odoo stays the ledger.",
    "version": "1.0.0",
    "category": "Accounting/Accounting",
    "author": "Custara",
    "website": "https://custara.xyz",
    "license": "LGPL-3",
    "depends": ["account"],
    "data": [
        "views/res_config_settings.xml",
        "views/account_move.xml",
    ],
    "installable": True,
    "application": False,
    "description": """
Custara is the AP control plane. Odoo stays the ledger.

Approved bills can settle in Arc testnet USDC until mainnet is explicitly gated.
Do not list this as a mainnet payment app.

Install, set the Custara API URL and Partner API key under Settings → Accounting,
then use Send to Custara on a vendor bill or credit.
""",
}
