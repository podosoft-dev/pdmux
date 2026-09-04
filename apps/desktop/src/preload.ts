import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("pdmuxDesktop", Object.freeze({
  isDesktop: true,
  platform: process.platform,
}));
