"""Unit tests that do not require a running Frappe site."""

from __future__ import annotations

import json
import unittest


def build_payload_like(doc) -> dict:
    """Mirror custara_ap.purchase_invoice._build_payload without importing frappe."""
    items = []
    for row in doc.get("items") or []:
        items.append(
            {
                "item_code": row.get("item_code"),
                "item_name": row.get("item_name"),
                "description": row.get("description") or row.get("item_name"),
                "qty": row.get("qty"),
                "rate": row.get("rate"),
                "amount": row.get("amount"),
                "expense_account": row.get("expense_account"),
                "purchase_order": row.get("purchase_order"),
            }
        )
    taxes = []
    for row in doc.get("taxes") or []:
        taxes.append(
            {
                "description": row.get("description") or row.get("account_head"),
                "tax_amount": row.get("tax_amount"),
                "rate": row.get("rate"),
            }
        )
    return {
        "system": "erpnext",
        "sync": True,
        "payload": {
            "name": doc.name,
            "supplier": doc.get("supplier"),
            "supplier_name": doc.get("supplier_name"),
            "grand_total": doc.get("grand_total"),
            "net_total": doc.get("net_total"),
            "total_taxes_and_charges": doc.get("total_taxes_and_charges"),
            "outstanding_amount": doc.get("outstanding_amount"),
            "currency": doc.get("currency"),
            "is_return": 1 if doc.get("is_return") else 0,
            "items": items,
            "taxes": taxes,
        },
    }


class Doc:
    name = "PINV-0001"

    def get(self, key, default=None):
        data = {
            "supplier": "SUP-1",
            "supplier_name": "Acme",
            "grand_total": 1100,
            "net_total": 1000,
            "total_taxes_and_charges": 100,
            "outstanding_amount": 1100,
            "currency": "NGN",
            "is_return": 0,
            "items": [
                {
                    "item_code": "A",
                    "item_name": "Widget",
                    "qty": 1,
                    "rate": 1000,
                    "amount": 1000,
                }
            ],
            "taxes": [{"description": "VAT", "tax_amount": 100}],
        }
        return data.get(key, default)


class PayloadTests(unittest.TestCase):
    def test_purchase_invoice_shape(self):
        payload = build_payload_like(Doc())
        self.assertEqual(payload["system"], "erpnext")
        self.assertEqual(payload["payload"]["name"], "PINV-0001")
        self.assertEqual(payload["payload"]["supplier_name"], "Acme")
        self.assertEqual(payload["payload"]["items"][0]["item_code"], "A")
        self.assertEqual(payload["payload"]["taxes"][0]["tax_amount"], 100)
        json.dumps(payload)


if __name__ == "__main__":
    unittest.main()
