import type { Metadata } from "next";
import { Users } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Avatar, EmptyState, Panel } from "@/ui";
import { PageHeader } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { claimedNotifyServices, listMembers } from "@/server/queries/settings/users";
import { readMobileAppDevices } from "@/server/queries/ha/registry";
import { notifyCandidates, unclaimedCandidates } from "@/features/settings/notify";
import { AddDeviceDialog, ColorEditor, DeviceRow } from "./UsersClient";

export const metadata: Metadata = { title: "Users" };

/**
 * `/settings/users` — who is in this household and which phones reach them.
 *
 * There is no "add user" button and there will not be one: creating an account and setting a
 * password both go through `pnpm vh-admin` on the machine
 * (`docs/design-notes/auth-security-operations.md` §4.1). A household of two does not need a
 * privileged tier in the browser, and not having one removes a whole class of way in.
 *
 * There is no delete button either. Removing a member would orphan their completion history, and
 * the history is the one thing this app must never lose.
 */
export default async function UsersSettingsPage() {
  await requireSessionPage("/settings/users");
  const { db } = pageContext();
  const members = listMembers(db);
  const claimed = claimedNotifyServices(db);
  const candidates = unclaimedCandidates(
    notifyCandidates(readMobileAppDevices(db)),
    claimed,
  );

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="The people in this household. No roles and no invitations: both members can do everything, and every action records who did it."
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No accounts yet"
          description="Accounts are created on the machine, not from a browser."
          bullets={[
            "pnpm vh-admin create-user — adds a member with a username and a password.",
            "pnpm vh-admin set-password — the only password recovery there is, because there is no mail transport to send a reset link through.",
            "Your own password is changed under Settings → Security, from any signed-in session.",
          ]}
          note="This is deliberate. With two accounts on a private hostname, a browser-reachable admin tier would be more risk than convenience."
        />
      ) : (
        members.map((member) => (
          <Panel
            key={member.id}
            title={
              <span className="flex items-center gap-2.5">
                <Avatar name={member.name} color={member.displayColor} size="sm" />
                {member.name}
              </span>
            }
            subtitle={`@${member.username}`}
          >
            <div className="flex flex-col gap-5">
              <ColorEditor
                userId={member.id}
                userName={member.name}
                color={member.displayColor}
              />

              <div className="border-t border-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                    Phones that reach {member.name}
                  </h3>
                  <AddDeviceDialog
                    userId={member.id}
                    userName={member.name}
                    candidates={candidates}
                  />
                </div>

                {member.devices.length === 0 ? (
                  <p className="mt-2 max-w-prose text-sm leading-6 text-ink-2">
                    No device registered, so {member.name} receives no reminders. The tasks still
                    exist and still show on Today — nothing is silently dropped, it simply does not
                    reach a phone.
                  </p>
                ) : (
                  <ul className="mt-1 flex list-none flex-col divide-y divide-line">
                    {member.devices.map((device) => (
                      <DeviceRow key={device.id} device={device} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Panel>
        ))
      )}

      <Panel title="What is not on this page" subtitle="And why.">
        <ul className="flex list-none flex-col gap-2 text-sm leading-6 text-ink-2">
          <li>
            <strong className="font-semibold text-ink">Creating an account.</strong> Use{" "}
            <code className="font-mono text-xs">pnpm vh-admin create-user</code> on the machine.
            The browser has no privileged tier, which is one fewer thing to attack.
          </li>
          <li>
            <strong className="font-semibold text-ink">Resetting somebody’s password.</strong>{" "}
            <code className="font-mono text-xs">pnpm vh-admin set-password</code>. There is no mail
            transport, so there is no reset link to send — and none to steal.
          </li>
          <li>
            <strong className="font-semibold text-ink">Changing your own password.</strong> Under
            Settings → Security, from any signed-in session.
          </li>
          <li>
            <strong className="font-semibold text-ink">Deleting a member.</strong> Not offered.
            Their completions are the record of what was done to this house, and a name has to stay
            attached to them.
          </li>
        </ul>
      </Panel>
    </>
  );
}
