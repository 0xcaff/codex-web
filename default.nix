{
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
    appVersion = "26.415.20818";
    cliVersion = "0.121.0";
    codexZip = pkgs.fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-${appVersion}.zip";
      hash = "sha256-NQgcjVeR9ACr2ZinsWSlR8GTsak6zuv1Qv+OyPIMtUg=";
    };
  in
  {
    devShells.default = pkgs.mkShell {
      HOSTED_CODEX_APP_ZIP = codexZip;

      packages = [
        pkgs.nodejs
        pkgs.yarn
        pkgs.unzip
        pkgs.patch
      ];
    };

    packages = {
      default =
        let
          nodeSources = pkgs.srcOnly pkgs.nodejs;
        in
        pkgs.stdenv.mkDerivation {
          HOSTED_CODEX_APP_ZIP = codexZip;

          pname = "codex-hosted";
          version = "1.0.0";
          src = ./.;

          yarnOfflineCache = pkgs.fetchYarnDeps {
            yarnLock = ./yarn.lock;
            hash = "sha256-T/sWEIHRtxtF5HUvBOGryK1mtnZ6mAcpyIhugeDWhbQ=";
          };

          nativeBuildInputs = [
            pkgs.yarnConfigHook
            pkgs.yarnBuildHook
            pkgs.yarnInstallHook
            pkgs.nodejs
            pkgs.yarn
            pkgs.unzip
            pkgs.patch
            pkgs.python3
            pkgs.removeReferencesTo
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.cctools ];

          preInstall = ''
            # Keep only extracted asar artifacts for packaging.
            rm -rf scratch/Codex.app

            # yarn pack drops any directory named node_modules, so rename the
            # nested asar tree in-place to keep it in the package output.
            mv scratch/asar/node_modules scratch/asar/asar_node_modules
          '';

          postInstall = ''
            mv $out/lib/node_modules/codex-hosted/scratch/asar/{asar_,}node_modules

            pushd $out/lib/node_modules/codex-hosted/node_modules/better-sqlite3
            npm run build-release --offline --nodedir="${nodeSources}"
            rm -rf build/Release/{.deps,obj,obj.target,test_extension.node}
            find build -type f -exec ${pkgs.lib.getExe pkgs.removeReferencesTo} -t "${nodeSources}" {} \;
            popd
          '';
        };

      codex_remote_proxy = pkgs.writeShellApplication {
        name = "codex_remote_proxy";
        runtimeInputs = with pkgs; [
          bash
          coreutils
          websocat
        ];
        text = builtins.readFile ./scripts/codex_remote_proxy;
      };
    };
  }
)
