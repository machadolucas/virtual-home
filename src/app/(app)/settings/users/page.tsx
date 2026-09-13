import type { Metadata } from "next";
import { Users } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { readMemberAccess } from "@/domain/memberAccess";
import { CreateMember, ManageMember } from "./MemberManagement";
import { Avatar, EmptyState, Panel } from "@/ui";
import { PageHeader } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { claimedNotifyServices, listMembers } from "@/server/queries/settings/users";
import { readMobileAppDevices } from "@/server/queries/ha/registry";
import { notifyCandidates, unclaimedCandidates } from "@/features/settings/notify";
import { AddDeviceDialog, ColorEditor, DeviceRow } from "./UsersClient";

export const metadata: Metadata = { title: "Users" };

export default async function UsersSettingsPage() {
  const session = await requireSessionPage("/settings/users");
  const { db } = pageContext();
  const members = listMembers(db);
  const owner = readMemberAccess(db, session.user.id)?.role === "owner";
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
        description="Members use household features. Owners also manage accounts and access."
        actions={owner ? <CreateMember/> : undefined}
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No accounts yet"
          description="Use local account recovery to create the first owner."
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
            subtitle={`@${member.username} · ${member.role}${member.active ? "" : " · inactive"}`}
          >
            <div className="flex flex-col gap-5">
              {owner && <ManageMember member={member} members={members}/>}
              {owner && <ColorEditor
                userId={member.id}
                userName={member.name}
                color={member.displayColor}
              />}

              <div className="border-t border-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                    Phones that reach {member.name}
                  </h3>
                  {owner && member.active && <AddDeviceDialog
                    userId={member.id}
                    userName={member.name}
                    candidates={candidates}
                  />}
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
                      owner ? <DeviceRow key={device.id} device={device} /> : <li key={device.id} className="py-2 text-sm">{device.label} · {device.isActive ? "Enabled" : "Paused"}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Panel>
        ))
      )}

      <p className="text-sm text-ink-3">Your own password and sessions are in Security. A deactivated account keeps its history. Local account recovery remains available with vh-admin.</p>
    </>
  );
}
