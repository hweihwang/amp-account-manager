cask "amp-account-manager" do
  version "0.1.3"
  sha256 "4bf70f54769f57de9adea9e64fea7b7c88f702828d13378c7ed846e790a56978"

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
