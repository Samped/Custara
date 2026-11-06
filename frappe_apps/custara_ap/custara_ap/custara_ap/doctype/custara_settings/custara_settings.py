# Copyright (c) 2026, Custara and contributors
# License: MIT

import frappe
from frappe.model.document import Document


class CustaraSettings(Document):
    def validate(self):
        url = (self.api_url or "").strip().rstrip("/")
        if url and not (url.startswith("https://") or url.startswith("http://")):
            frappe.throw("Custara API URL must start with http:// or https://")
        self.api_url = url or "https://custara.xyz"
