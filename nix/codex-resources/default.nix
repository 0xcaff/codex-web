{
  self,
  flake-utils,
  nixpkgs,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    linuxOpenChromeWindow =
      let
        chromeExtensionId = "hehggadaopoacecdllhhajmbjkdcmajg";
        chromeNativeHostName = "com.openai.codexextension";
        chromeExtensionUpdateUrl = "https://clients2.google.com/service/update2/crx";
        chromeNativeHostManifest = pkgs.writeText "codex-chrome-native-host-manifest.json" (
          builtins.toJSON {
            name = chromeNativeHostName;
            description = "Codex chrome native messaging host";
            type = "stdio";
            path = "${self.packages.${system}.codex_chrome_extension_host}/bin/codex-chrome-extension-host";
            allowed_origins = [ "chrome-extension://${chromeExtensionId}/" ];
          }
        );
        linuxProfileRootTemplate = pkgs.linkFarm "codex-brave-profile-root-template" [
          {
            name = "xdg-config/BraveSoftware/Brave-Browser/NativeMessagingHosts/${chromeNativeHostName}.json";
            path = chromeNativeHostManifest;
          }
          {
            name = "user-data/External Extensions/${chromeExtensionId}.json";
            path = pkgs.writeText "codex-chrome-extension.json" (
              builtins.toJSON {
                external_update_url = chromeExtensionUpdateUrl;
              }
            );
          }
          {
            name = "user-data/policies/managed/codex.json";
            path = pkgs.writeText "codex-chrome-policy.json" (
              builtins.toJSON {
                ExtensionInstallForcelist = [ "${chromeExtensionId};${chromeExtensionUpdateUrl}" ];
                AudioCaptureAllowed = false;
                VideoCaptureAllowed = false;
                DefaultClipboardSetting = 2;
                DefaultWebUsbGuardSetting = 2;
                DefaultSerialGuardSetting = 2;
              }
            );
          }
          {
            name = "user-data/Codex/Preferences";
            path = pkgs.writeText "codex-chrome-preferences.json" (
              builtins.toJSON {
                profile = {
                  name = "Codex";
                };
                extensions = {
                  settings = {
                    "${chromeExtensionId}" = {
                      external_update_url = chromeExtensionUpdateUrl;
                    };
                  };
                };
              }
            );
          }
        ];
      in
      pkgs.writeShellScriptBin "codex-open-chrome-window" ''
        set -euo pipefail

        if [[ "$#" -gt 0 ]]; then
          echo "Usage: scripts/open-chrome-window" >&2
          exit 2
        fi

        profile_root="$(mktemp -d -t codex-brave-profile.XXXXXX)"

        home_dir="$profile_root/home"
        xdg_config_home="$profile_root/xdg-config"
        xdg_cache_home="$profile_root/xdg-cache"
        user_data_dir="$profile_root/user-data"
        profile_name="Codex"

        cp -RL --no-preserve=mode,ownership,timestamps ${linuxProfileRootTemplate}/. "$profile_root"

        mkdir -p \
          "$home_dir" \
          "$xdg_cache_home" \
          "$xdg_config_home" \
          "$user_data_dir"

        chmod -R u+w "$profile_root"

        log_file="$profile_root/brave.log"
        HOME="$home_dir" XDG_CONFIG_HOME="$xdg_config_home" XDG_CACHE_HOME="$xdg_cache_home" \
          ${pkgs.xvfb-run}/bin/xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
          ${pkgs.brave}/bin/brave \
          --user-data-dir="$user_data_dir" \
          --profile-directory="$profile_name" \
          --no-first-run \
          --no-default-browser-check \
          --disable-dev-shm-usage \
          --force-device-scale-factor=1 \
          --start-maximized \
          --window-position=0,0 \
          --window-size=1920,1080 \
          --new-window about:blank
      '';
  in
  {
    packages.codex_resources = pkgs.stdenvNoCC.mkDerivation {
      pname = "codex-resources";
      version = self.packages.${system}.codexZip.version;

      src = self.packages.${system}.codexZip;

      nativeBuildInputs = [
        pkgs.patch
        pkgs.unzip
      ];

      dontConfigure = true;
      dontBuild = true;

      unpackPhase = ''
        runHook preUnpack

        unzip -q "$src"

        runHook postUnpack
      '';

      installPhase = ''
        runHook preInstall

        mkdir -p "$out"
        cp -R ChatGPT.app/Contents/Resources/plugins "$out/plugins"

        chromeManifestScript="$out/plugins/openai-bundled/plugins/chrome/scripts/installManifest.mjs"
        chromeExtensionHost="${
          self.packages.${system}.codex_chrome_extension_host
        }/bin/codex-chrome-extension-host"
        substituteInPlace "$chromeManifestScript" \
          --replace-fail 'let t=a(o);' "let t=\"$chromeExtensionHost\";" \
          --replace-fail 'path:a(o)' "path:\"$chromeExtensionHost\""
      ''
      + pkgs.lib.optionalString (system == "x86_64-linux") ''
        chromePluginRoot="$out/plugins/openai-bundled/plugins/chrome"
        patch --batch --forward --strip 1 --directory "$chromePluginRoot" < ${./patches/chrome-linux-brave-skill.patch}
        substituteInPlace "$chromePluginRoot/skills/chrome/SKILL.md" \
          --replace-fail '@openChromeWindow@' '${linuxOpenChromeWindow}/bin/codex-open-chrome-window'
        rm "$chromePluginRoot/scripts/open-chrome-window.js"
      ''
      + pkgs.lib.optionalString (system == "aarch64-darwin") ''
        install -m755 ChatGPT.app/Contents/Resources/node "$out/node"
        install -m755 ChatGPT.app/Contents/Resources/node_repl "$out/node_repl"
      ''
      + pkgs.lib.optionalString (system == "x86_64-linux") ''
        install -m755 ${pkgs.nodejs}/bin/node "$out/node"
        install -m755 ${
          self.packages.${system}.codex-primary-runtime
        }/dependencies/bin/node_repl "$out/node_repl"
      ''
      + pkgs.lib.optionalString (system != "aarch64-darwin" && system != "x86_64-linux") ''
        echo "codex resources are only packaged for aarch64-darwin and x86_64-linux" >&2
        exit 1
      ''
      + ''
        runHook postInstall
      '';
    };
  }
)
