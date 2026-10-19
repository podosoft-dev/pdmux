export interface DesktopMessages {
  localHost: string;
  selectProfile: string;
  settings: string;
  show: string;
  backup: string;
  openData: string;
  checkUpdates: string;
  quit: string;
  backupComplete: string;
  backupFailed: string;
  updateReady: string;
  updateInstall: string;
  updateFailed: string;
  updateChecking: string;
  updateAvailable: string;
  updateDownload: string;
  updateDownloading: string;
  updatePreparing: string;
  updateCurrent: string;
  updateDisabled: string;
  updateError: string;
  updateBackupFailed: string;
  updateRestartRequired: string;
  updateRestart: string;
  updateLater: string;
  updateClose: string;
  runtimeFailed: string;
}

const ENGLISH: DesktopMessages = {
  localHost: "This computer",
  selectProfile: "Choose your existing local profile",
  show: "Show PDMux",
  settings: "Settings…",
  backup: "Create backup",
  openData: "Open data folder",
  checkUpdates: "Check for updates",
  quit: "Quit",
  backupComplete: "Backup completed",
  backupFailed: "Backup failed",
  updateReady: "Download complete. Restart PDMux to install the update. Running plain shell terminals will close.",
  updateInstall: "Install and restart",
  updateFailed: "Update installation failed",
  updateChecking: "Checking for updates…",
  updateAvailable: "PDMux {version} is available. Download the update?",
  updateDownload: "Download update",
  updateDownloading: "Downloading update…",
  updatePreparing: "Preparing installation…",
  updateCurrent: "PDMux is up to date. No updates are available.",
  updateDisabled: "Update checks are available in the installed release of PDMux.",
  updateError: "The update could not be completed. Check your connection and try again.",
  updateBackupFailed: "The update was not installed because the workspace backup failed. PDMux keeps running.",
  updateRestartRequired: "The installation could not finish. Restart PDMux to continue using it.",
  updateRestart: "Restart PDMux",
  updateLater: "Later",
  updateClose: "Close",
  runtimeFailed: "The local PDMux runtime stopped unexpectedly.",
};

const KOREAN: DesktopMessages = {
  localHost: "이 컴퓨터",
  selectProfile: "기존 로컬 프로필을 선택하세요",
  show: "PDMux 열기",
  settings: "설정…",
  backup: "백업 만들기",
  openData: "데이터 폴더 열기",
  checkUpdates: "업데이트 확인",
  quit: "종료",
  backupComplete: "백업이 완료되었습니다",
  backupFailed: "백업에 실패했습니다",
  updateReady: "다운로드가 완료되었습니다. PDMux를 재시작하여 업데이트를 설치하세요. 실행 중인 일반 셸 터미널은 종료됩니다.",
  updateInstall: "설치 후 다시 시작",
  updateFailed: "업데이트 설치에 실패했습니다",
  updateChecking: "업데이트를 확인하고 있습니다…",
  updateAvailable: "PDMux {version} 업데이트가 있습니다. 다운로드하시겠습니까?",
  updateDownload: "업데이트 다운로드",
  updateDownloading: "업데이트를 다운로드하고 있습니다…",
  updatePreparing: "업데이트 설치를 준비하고 있습니다…",
  updateCurrent: "최신 버전의 PDMux입니다. 사용 가능한 업데이트가 없습니다.",
  updateDisabled: "업데이트 확인은 정식 설치된 PDMux에서 사용할 수 있습니다.",
  updateError: "업데이트를 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
  updateBackupFailed: "작업공간 백업에 실패하여 업데이트를 설치하지 않았습니다. PDMux는 계속 실행됩니다.",
  updateRestartRequired: "설치를 마치지 못했습니다. 계속 사용하려면 PDMux를 다시 시작해야 합니다.",
  updateRestart: "PDMux 다시 시작",
  updateLater: "나중에",
  updateClose: "닫기",
  runtimeFailed: "로컬 PDMux 런타임이 예기치 않게 종료되었습니다.",
};

export function desktopMessages(locale: string): DesktopMessages {
  return locale.toLowerCase().startsWith("ko") ? KOREAN : ENGLISH;
}
