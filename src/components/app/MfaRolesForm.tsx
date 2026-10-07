"use client";

import { SettingsJsonForm } from "@/components/app/SettingsForms";

export function MfaRolesForm({ mfaRoles }: { mfaRoles: string[] }) {
  return (
    <SettingsJsonForm action="save_mfa_roles" className="mt-4">
      <div className="flex flex-wrap gap-3 text-sm">
        {(["admin", "approver", "payer", "viewer", "auditor"] as const).map((role) => (
          <label key={role} className="flex items-center gap-2">
            <input name="mfaRole" type="checkbox" value={role} defaultChecked={mfaRoles.includes(role)} />
            {role}
          </label>
        ))}
      </div>
      <button type="submit" className="btn btn-secondary mt-4">
        Save MFA policy
      </button>
    </SettingsJsonForm>
  );
}
