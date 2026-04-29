{
  flake-utils,
  nixpkgs,
  self,
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
    appVersion = "26.422.71525";
    codexZip = pkgs.fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-${appVersion}.zip";
      hash = "sha256-riGX0oUG9qYN9F5xgxrgFh//saa/g6MEVnNAH4bO0tU=";
    };
    codex = self.packages.${system}.codex;
  in
  {
    devShells.default = pkgs.mkShell {
      HOSTED_CODEX_APP_ZIP = codexZip;

      packages = [
        codex
        pkgs.nodejs
        pkgs.yarn
        pkgs.unzip
        pkgs.patch
      ];
    };

    packages =
      let
        nodeSources = pkgs.srcOnly pkgs.nodejs;
        yarnOfflineCache = pkgs.fetchYarnDeps {
          yarnLock = ./yarn.lock;
          hash = "sha256-PPymV+XLEGj4JtqKUa+ctQIjnvbOQ0sFpTuRd34FEbM=";
        };

        betterSqlite3Native = pkgs.stdenv.mkDerivation {
          pname = "better-sqlite3-native";
          version = "12.9.0";
          src = pkgs.runCommand "better-sqlite3-build-src" { nativeBuildInputs = [ pkgs.jq ]; } ''
            mkdir -p "$out"

            ${pkgs.lib.getExe pkgs.jq} '{
              name: "better-sqlite3-build",
              version: "0.0.0",
              private: true,
              dependencies: {
                "better-sqlite3": .dependencies["better-sqlite3"]
              }
            }' ${./package.json} > "$out/package.json"

            cp ${./yarn.lock} "$out/yarn.lock"
          '';
          inherit yarnOfflineCache;

          nativeBuildInputs = [
            pkgs.yarnConfigHook
            pkgs.nodejs
            pkgs.yarn
            pkgs.python3
            pkgs.removeReferencesTo
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.cctools ];

          buildPhase = ''
            runHook preBuild

            pushd node_modules/better-sqlite3
            npm run build-release --offline --nodedir="${nodeSources}"
            rm -rf build/Release/{.deps,obj,obj.target,test_extension.node}
            find build -type f -exec ${pkgs.lib.getExe pkgs.removeReferencesTo} -t "${nodeSources}" {} \;
            popd

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p "$out"
            cp -R node_modules/better-sqlite3/build "$out/build"

            runHook postInstall
          '';
        };
      in
      {
        default = pkgs.stdenv.mkDerivation {
          HOSTED_CODEX_APP_ZIP = codexZip;

          pname = "codex-web";
          version = "1.0.0";
          src = ./.;

          inherit yarnOfflineCache;

          nativeBuildInputs = [
            pkgs.yarnConfigHook
            pkgs.yarnBuildHook
            pkgs.yarnInstallHook
            pkgs.nodejs
            pkgs.yarn
            pkgs.unzip
            pkgs.patch
          ];

          preBuild = ''
            patchShebangs scripts
          '';

          preInstall = ''
            # Keep only extracted asar artifacts for packaging.
            rm -rf scratch/Codex.app

            # yarn pack drops any directory named node_modules, so rename the
            # nested asar tree in-place to keep it in the package output.
            mv scratch/asar/node_modules scratch/asar/asar_node_modules
          '';

          postInstall = ''
            mv $out/lib/node_modules/codex-web/scratch/asar/{asar_,}node_modules

            addon="$out/lib/node_modules/codex-web/node_modules/better-sqlite3"
            rm -rf "$addon/build"
            ln -s ${betterSqlite3Native}/build "$addon/build"
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
