export const QUEST_ROOM_SETUP_GUIDE = "On Quest, find Space Setup in Settings under Physical Space or Environment Setup.";
const requested = new WeakSet<XRSession>();

export function canOpenHeadsetRoomSetup(session: XRSession): boolean {
  return typeof session.initiateRoomCapture === "function" && !requested.has(session);
}

/** Invoke only from a deliberate headset menu activation. The browser allows one attempt per session. */
export async function openHeadsetRoomSetup(session: XRSession): Promise<boolean> {
  if (!canOpenHeadsetRoomSetup(session)) return false;
  requested.add(session);
  try {
    await session.initiateRoomCapture!();
    return true;
  } catch {
    return false;
  }
}
