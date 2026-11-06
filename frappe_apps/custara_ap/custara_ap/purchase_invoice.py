# Copyright (c) 2026, Custara and contributors
# License: MIT

from __future__ import annotations

import json
import urllib.error
import urllib.request

import frappe
from frappe import _


def _settings():
    if not frappe.db.exists("DocType", "Custara Settings"):
        return None
    try:
        return frappe.get_single("Custara Settings")
    except Exception:
        return None


def _build_payload(doc) -> dict:
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
            "total": doc.get("total"),
            "total_taxes_and_charges": doc.get("total_taxes_and_charges"),
            "outstanding_amount": doc.get("outstanding_amount"),
            "currency": doc.get("currency"),
            "due_date": str(doc.get("due_date") or ""),
            "posting_date": str(doc.get("posting_date") or ""),
            "bill_no": doc.get("bill_no") or "",
            "bill_date": str(doc.get("bill_date") or ""),
            "remarks": doc.get("remarks") or "",
            "is_return": 1 if doc.get("is_return") else 0,
            "status": doc.get("status"),
            "docstatus": doc.get("docstatus"),
            "payment_terms_template": doc.get("payment_terms_template"),
            "company": doc.get("company"),
            "items": items,
            "taxes": taxes,
        },
    }


def push_purchase_invoice(doc, *, force: bool = False) -> dict:
    """POST Purchase Invoice to Custara /api/v1/erp/ingest."""
    settings = _settings()
    if not settings:
        frappe.throw(_("Install Custara Settings first."))
    base = (settings.api_url or "").rstrip("/")
    key = settings.get_password("api_key") if hasattr(settings, "get_password") else settings.api_key
    if not base or not key:
        frappe.throw(_("Set Custara API URL and Partner API key under Custara Settings."))

    if not force and not settings.auto_push_on_submit:
        return {"skipped": True, "reason": "auto_push_disabled"}

    payload = _build_payload(doc)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/v1/erp/ingest",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Idempotency-Key": f"erpnext-{doc.name}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            if resp.status >= 400:
                frappe.throw(_("Custara rejected Purchase Invoice {0}.").format(doc.name))
            result = json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:200]
        frappe.throw(_("Could not reach Custara ({0}): {1}").format(err.code, detail))
    except Exception as err:
        frappe.throw(_("Could not reach Custara: {0}").format(err))

    comment = _(
        "Sent to Custara. Settlement, if paid, is Arc USDC on the Custara API host "
        "(mainnet at custara.xyz; demos may use testnet.custara.xyz)."
    )
    doc.add_comment("Comment", comment)
    try:
        settings.db_set("last_push_status", f"{doc.name} ok", update_modified=False)
    except Exception:
        pass
    return result if isinstance(result, dict) else {"ok": True}


def on_submit(doc, method=None):
    settings = _settings()
    if not settings or not settings.auto_push_on_submit:
        return
    if not (settings.api_url or "").strip() or not settings.api_key:
        return
    try:
        push_purchase_invoice(doc, force=True)
    except Exception as err:
        frappe.log_error(title="Custara auto-push skipped", message=str(err))


@frappe.whitelist()
def send_to_custara(name: str):
    doc = frappe.get_doc("Purchase Invoice", name)
    if doc.docstatus != 1:
        frappe.throw(_("Submit the Purchase Invoice before sending to Custara."))
    return push_purchase_invoice(doc, force=True)
