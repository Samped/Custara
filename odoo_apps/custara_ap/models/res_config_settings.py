from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    custara_api_url = fields.Char(
        string="Custara API URL",
        config_parameter="custara.api_url",
        default="https://custara.xyz",
    )
    custara_api_key = fields.Char(
        string="Custara API key",
        config_parameter="custara.api_key",
    )
    custara_settlement_note = fields.Char(
        string="Settlement rail",
        default="Arc testnet USDC — not mainnet",
        readonly=True,
    )
