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
    appVersion = "26.1007.30912";
    codexZip = pkgs.fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${appVersion}.zip";
      hash = "sha256-tpmowtWi8jysWdxnOI4lr0v1/C+2qzD/okOpaOT4FaM=";
    };
    codex = self.packages.${system}.codex;
  in
  {
    devShells.default = pkgs.mkShell {
      HOSTED_CODEX_APP_ZIP = codexZip;

      packages = [
        codex
        pkgs.nodejs
        pkgs.unzip
        pkgs.patch
      ];
    };

    packages =
      let
        nodeSources = pkgs.srcOnly pkgs.nodejs;
        npmDeps = pkgs.importNpmLock {
          npmRoot = ./.;
        };

        betterSqlite3Native = pkgs.stdenv.mkDerivation {
          pname = "better-sqlite3-native";
          version = "12.9.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./package-lock.json
            ];
          };

          inherit npmDeps;

          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.importNpmLock.npmConfigHook
            pkgs.nodejs
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

        preparedApp = pkgs.buildNpmPackage {
          pname = "codex-web-prepared-app";
          version = appVersion;
          HOSTED_CODEX_APP_ZIP = codexZip;
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./package-lock.json
              ./scripts/prepare_asar
              ./assets
              ./patches
              ./src/browser
              ./vite.browser.config.ts
            ];
          };

          inherit npmDeps;
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmRebuildFlags = [ "--ignore-scripts" ];
          nativeBuildInputs = [
            pkgs.unzip
            pkgs.patch
          ];

          buildPhase = ''
            runHook preBuild
            patchShebangs scripts
            npm run prepare:asar
            npm run build:browser
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mv scratch/asar "$out"
            runHook postInstall
          '';

          # The final package performs fixup after assembling its runtime files.
          dontFixup = true;
        };
      in
      {
        prepared-app = preparedApp;

        default = pkgs.buildNpmPackage {
          pname = "codex-web";
          version = "1.0.0";
          src = ./.;

          inherit npmDeps;
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build:server";
          npmInstallFlags = [ "--omit=dev" ];
          npmRebuildFlags = [ "--ignore-scripts" ];

          installPhase = ''
            runHook preInstall

            packageOut="$out/lib/node_modules/codex-web"
            mkdir -p "$packageOut/src" "$packageOut/scratch" "$out/bin"

            echo "Installing server and package metadata"
            cp package.json README.md "$packageOut/"
            cp -r src/server "$packageOut/src/"
            find "$packageOut/src/server" -type f ! -name '*.js' -delete

            echo "Installing cached upstream app"
            cp -r --no-preserve=mode ${preparedApp} "$packageOut/scratch/asar"

            echo "Installing production dependencies"
            cp -r node_modules "$packageOut/node_modules"
            addon="$packageOut/node_modules/better-sqlite3"
            rm -rf "$addon/build"
            ln -s ${betterSqlite3Native}/build "$addon/build"

            makeWrapper ${pkgs.lib.getExe pkgs.nodejs} "$out/bin/codex-web" \
              --add-flags "$packageOut/src/server/main.js"

            runHook postInstall
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
