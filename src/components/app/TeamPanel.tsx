"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { INVITE_ROLE_OPTIONS, roleLabel } from "@/lib/roles";

export type TeamMember = {
  id: string;
  email: string;
  name: string;
  role: string;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  mfaEnabled: boolean;
};

async function postTeam(body: Record<string, unknown>) {
  const res = await fetch("/api/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function TeamPanel({
  members,
  currentUserId,
}: {
  members: TeamMember[];
  currentUserId: string;
}) {
  const router = useRouter();
  const active = members.filter((m) => !m.disabledAt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData(event.currentTarget);
      await postTeam({
        action: "invite_member",
        email: String(fd.get("email") || ""),
        name: String(fd.get("name") || "") || undefined,
        role: String(fd.get("role") || "viewer"),
      });
      event.currentTarget.reset();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRoleChange(userId: string, role: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postTeam({ action: "update_role", userId, role });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role update failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDisable(userId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postTeam({ action: "disable_member", userId });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disable failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="dash-panel">
        <h2 className="dash-h">Invite</h2>
        <form onSubmit={onInvite} className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="text-sm md:col-span-2">
            Email
            <input name="email" type="email" className="input mt-1" required placeholder="finance@acme.com" />
          </label>
          <label className="text-sm">
            Name
            <input name="name" className="input mt-1" placeholder="Optional" />
          </label>
          <label className="text-sm">
            Role
            <select name="role" className="input mt-1" defaultValue="viewer">
              {INVITE_ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value} title={r.description}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Invite
            </button>
            {error ? <p className="text-[0.72rem] text-danger">{error}</p> : null}
          </div>
        </form>
      </section>

      <section className="dash-panel dash-panel-flush">
        <div className="dash-panel-head dash-panel-pad">
          <h2 className="dash-h">Members</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-sm text-muted">
                    No members
                  </td>
                </tr>
              ) : (
                active.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-muted">{u.email}</p>
                    </td>
                    <td>
                      {u.id === currentUserId ? (
                        <span>{roleLabel(u.role)}</span>
                      ) : (
                        <select
                          className="input !h-8 !py-0 text-[0.78rem]"
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => onRoleChange(u.id, e.target.value)}
                          aria-label={`Role for ${u.name}`}
                        >
                          {INVITE_ROLE_OPTIONS.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{u.mfaEnabled ? "MFA on" : "Active"}</td>
                    <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 10) : "—"}</td>
                    <td>
                      {u.id !== currentUserId ? (
                        <button
                          type="button"
                          className="text-xs text-danger hover:underline"
                          disabled={busy}
                          onClick={() => onDisable(u.id)}
                        >
                          Disable
                        </button>
                      ) : (
                        <span className="text-xs text-muted">You</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
