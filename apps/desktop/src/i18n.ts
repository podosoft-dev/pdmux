export interface DesktopMessages {
  show: string;
  backup: string;
  openData: string;
  checkUpdates: string;
  quit: string;
  backupComplete: string;
  backupFailed: string;
  updateReady: string;
  updateInstall: string;
  cancel: string;
  runtimeFailed: string;
}

const ENGLISH: DesktopMessages = {
  show: "Show pdmux",
  backup: "Create backup",
  openData: "Open data folder",
  checkUpdates: "Check for updates",
  quit: "Quit",
  backupComplete: "Backup completed",
  backupFailed: "Backup failed",
  updateReady: "An update is ready to install. pdmux will create a backup first.",
  updateInstall: "Install and restart",
  cancel: "Cancel",
  runtimeFailed: "The local pdmux runtime stopped unexpectedly.",
};

const KOREAN: DesktopMessages = {
  show: "pdmux 열기",
  backup: "백업 만들기",
  openData: "데이터 폴더 열기",
  checkUpdates: "업데이트 확인",
  quit: "종료",
  backupComplete: "백업이 완료되었습니다",
  backupFailed: "백업에 실패했습니다",
  updateReady: "설치할 업데이트가 있습니다. 먼저 pdmux 백업을 만듭니다.",
  updateInstall: "설치 후 다시 시작",
  cancel: "취소",
  runtimeFailed: "로컬 pdmux 런타임이 예기치 않게 종료되었습니다.",
};

export function desktopMessages(locale: string): DesktopMessages {
  return locale.toLowerCase().startsWith("ko") ? KOREAN : ENGLISH;
}
