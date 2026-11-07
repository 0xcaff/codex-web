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
    nodejs = pkgs.nodejs_24;
    appVersion = "26.1103.32239";
    codexZip = pkgs.fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${appVersion}.zip";
      hash = "sha256-aNq8st/ukdJF5XDFzEVVLJbz63Gd7cmMkH76ZBl/pA0=";
    };
    codex = self.packages.${system}.codex;
  in
  {
    devShells.default = pkgs.mkShell {
      HOSTED_CODEX_APP_ZIP = codexZip;

      packages = [
        codex
        nodejs
        (pkgs.yarn.override { inherit nodejs; })
        pkgs.ripunzip
        pkgs.patch
      ];
    };

    packages =
      let
        nodeSources = pkgs.srcOnly nodejs;
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
            nodejs
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
        default = pkgs.buildNpmPackage {
          inherit nodejs;
          HOSTED_CODEX_APP_ZIP = codexZip;

          pname = "codex-web";
          version = "1.0.0";
          src = ./.;

          inherit npmDeps;
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build";
          npmInstallFlags = [ "--omit=dev" ];
          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.ripunzip
            pkgs.patch
          ];

          preBuild = ''
            patchShebangs scripts
          '';

          installPhase = ''
            runHook preInstall

            packageOut="$out/lib/node_modules/codex-web"
            mkdir -p "$packageOut/src" "$packageOut/scratch" "$out/bin"

            echo "Installing server and package metadata"
            cp package.json README.md "$packageOut/"
            cp -r src/server "$packageOut/src/"
            find "$packageOut/src/server" -type f ! -name '*.js' -delete

            echo "Installing upstream app"
            mv scratch/asar "$packageOut/scratch/asar"

            echo "Installing production dependencies"
            cp -r node_modules "$packageOut/node_modules"
            addon="$packageOut/node_modules/better-sqlite3"
            rm -rf "$addon/build"
            ln -s ${betterSqlite3Native}/build "$addon/build"

            makeWrapper ${pkgs.lib.getExe nodejs} "$out/bin/codex-web" \
              --add-flags "$packageOut/src/server/main.js"

            runHook postInstall
          '';
        };

        codex_remote_proxy = pkgs.writeShellApplication {
          name = "codex_remote_proxy";
          runtimeInputs = [
            codex
            pkgs.bash
            pkgs.coreutils
            pkgs.websocat
          ];
          text = builtins.readFile ./scripts/codex_remote_proxy;
        };
      };
  }
)
