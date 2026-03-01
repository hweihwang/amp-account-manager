cask "amp-account-manager" do
  version "0.1.1"
  sha256 "e64e2c8ca107a59d8db5ed5852839c917ab751d4afc02324aa8a234828495266"

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
