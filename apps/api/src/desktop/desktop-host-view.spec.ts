import { expect, it } from "bun:test";
import { desktopHostView } from "./desktop-router";

const cached = { label: "Mac 9B5E", online: true, connected: true, lastSeenAt: "2026-10-23T09:02:02.167Z" };

it("[TC-PDDESKTOP-028] a relayed host whose device is unreachable is not shown online from its cached view", () => {
  expect(desktopHostView(cached, false)).toMatchObject({ online: false, connected: false, lastSeenAt: cached.lastSeenAt, label: "Mac 9B5E" });
});

it("[TC-PDDESKTOP-028] a reachable device keeps the live state it reported", () => {
  expect(desktopHostView(cached, true)).toMatchObject({ online: true, connected: true });
  expect(desktopHostView({ ...cached, online: false }, true)).toMatchObject({ online: false });
});
