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
    appVersion = "26.513.20950";
    codexZip = pkgs.fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-${appVersion}.zip";
      hash = "sha256-zSlRaoUJc4eRFbe08qS/oyqaBbfW2Epjj3hlbEmA6Cw=";
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
      in
      {
        default = pkgs.buildNpmPackage {
          HOSTED_CODEX_APP_ZIP = codexZip;

          pname = "codex-web";
          version = "1.0.0";
          src = ./.;

          inherit npmDeps;

          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build";
          npmRebuildFlags = [ "--ignore-scripts" ];
          npmPruneFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.unzip
            pkgs.patch
          ];

          preBuild = ''
            patchShebangs scripts
          '';

          preInstall = ''
            # npm pack always runs the package prepare lifecycle. Nix already ran
            # the explicit build script above, so remove prepare in the sandbox.
            node -e '
              const fs = require("fs");
              const packageJsonPath = "package.json";
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
              delete packageJson.scripts.prepare;
              fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
            '

            # Keep only extracted asar artifacts for packaging.
            rm -rf scratch/Codex.app

            # npm pack drops directories named node_modules, so rename the nested
            # asar tree in-place to keep it in the package output.
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
