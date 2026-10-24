import json
import logging
import urllib.request

from odoo import _, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class AccountMove(models.Model):
    _inherit = "account.move"

    custara_sent_at = fields.Datetime(string="Sent to Custara", copy=False)

    def action_send_to_custara(self):
        icp = self.env["ir.config_parameter"].sudo()
        base = (icp.get_param("custara.api_url") or "").rstrip("/")
        key = icp.get_param("custara.api_key") or ""
        if not base or not key:
            raise UserError(_("Set Custara API URL and API key under Settings → Custara AP."))
        for move in self:
            if move.move_type not in ("in_invoice", "in_refund"):
                continue
            payload = {
                "system": "odoo",
                "sync": True,
                "payload": {
                    "id": move.id,
                    "name": move.name,
                    "partner_id": [move.partner_id.id, move.partner_id.display_name],
                    "amount_total": move.amount_total,
                    "amount_untaxed": move.amount_untaxed,
                    "amount_tax": move.amount_tax,
                    "currency_id": [move.currency_id.id, move.currency_id.name],
                    "invoice_date_due": str(move.invoice_date_due or ""),
                    "invoice_date": str(move.invoice_date or ""),
                    "invoice_origin": move.invoice_origin or "",
                    "ref": move.ref or "",
                    "payment_reference": move.payment_reference or "",
                    "move_type": move.move_type,
                    "state": move.state,
                    "payment_state": move.payment_state,
                    "amount_residual": move.amount_residual,
                    "invoice_line_ids": [
                        {
                            "name": line.name,
                            "quantity": line.quantity,
                            "price_unit": line.price_unit,
                            "price_subtotal": line.price_subtotal,
                        }
                        for line in move.invoice_line_ids
                    ],
                },
            }
            req = urllib.request.Request(
                f"{base}/api/v1/erp/ingest",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Idempotency-Key": f"odoo-{move.id}",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    if resp.status >= 400:
                        raise UserError(_("Custara rejected bill %s.") % move.name)
            except UserError:
                raise
            except Exception as err:
                _logger.warning("Custara push failed for %s: %s", move.name, err)
                raise UserError(_("Could not reach Custara: %s") % err)
            move.custara_sent_at = fields.Datetime.now()
            move.message_post(
                body=_("Sent to Custara. Settlement, if paid, is Arc testnet USDC — not mainnet.")
            )
        return True
