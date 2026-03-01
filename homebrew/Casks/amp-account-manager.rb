cask "amp-account-manager" do
  version "0.1.2"
  sha256 "c029c19bec237cadea2e9e6584e0abb0c692fc5da55dc1cfdafc7733213f1b15"

  url "https://github.com/hweihwang/amp-account-manager/releases/download/v#{version}/AmpAccountManager-mac-arm64.dmg"
  name "Amp Account Manager"
  desc "Desktop account manager and thread handoff assistant for Amp CLI."
  homepage "https://github.com/hweihwang/amp-account-manager"

  depends_on arch: :arm64
  auto_updates true

  app "Amp Account Manager.app"

  uninstall quit: "com.hweihwang.amp-account-manager"

  zap trash: [
    "~/Library/Application Support/Amp Account Manager",
    "~/Library/Logs/Amp Account Manager",
    "~/Library/Preferences/com.hweihwang.amp-account-manager.plist",
    "~/Library/Saved Application State/com.hweihwang.amp-account-manager.savedState",
  ]
end
