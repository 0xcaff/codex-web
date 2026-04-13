{
  description = "codex-hosted dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          asarSrc = pkgs.runCommandLocal "codex-hosted-yarn-src" { } ''
            mkdir -p "$out"
            cp ${./package.json} "$out/package.json"
            cp ${./yarn.lock} "$out/yarn.lock"
          '';

          asarOfflineCache = pkgs.fetchYarnDeps {
            yarnLock = ./yarn.lock;
            hash = "sha256-PwMr78hxbKHbHPPhOxZLb6JXr5+DtWlTvHX5j6pwbz8=";
          };

          asarFromYarn = pkgs.stdenvNoCC.mkDerivation {
            pname = "codex-hosted-asar";
            version = "1.0.0";
            src = asarSrc;
            yarnOfflineCache = asarOfflineCache;

            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.yarnConfigHook
              pkgs.makeWrapper
            ];

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib"
              cp -R node_modules "$out/lib/node_modules"

              mkdir -p "$out/bin"
              makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/asar" \
                --add-flags "$out/lib/node_modules/@electron/asar/bin/asar.mjs"

              runHook postInstall
            '';
          };

          src = pkgs.fetchurl {
            url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-26.409.20454.zip";
            hash = "sha256-J1xOgVwwXWIcU80Nwqg3xhQxQLHuuDPjpTGlhU2SybQ=";
          };

          extractCodex = pkgs.writeShellScriptBin "extract-codex" ''
            set -euo pipefail

            scratch_dir="$PWD/scratch"
            app_dir="$scratch_dir/Codex.app"
            asar_dir="$scratch_dir/asar"
            prettier_bin="${asarFromYarn}/lib/node_modules/.bin/prettier"

            mkdir -p "$scratch_dir"
            rm -rf "$app_dir" "$asar_dir"

            unzip -q -o "${src}" -d "$scratch_dir"

            ${asarFromYarn}/bin/asar extract \
              "$app_dir/Contents/Resources/app.asar" \
              "$asar_dir"

            if [ -d "$asar_dir/.vite/build" ]; then
              if [ ! -x "$prettier_bin" ]; then
                echo "Expected prettier from package.json deps at: $prettier_bin" >&2
                exit 1
              fi

              find "$asar_dir/.vite/build" -type f \( \
                -name "*.js" -o \
                -name "*.mjs" -o \
                -name "*.cjs" -o \
                -name "*.json" \
              \) -print0 | xargs -0 -r "$prettier_bin" --ignore-path /dev/null --write
            fi

            echo "Extracted Codex.app to $app_dir"
            echo "Extracted app.asar to $asar_dir"
            echo "Prettier applied to $asar_dir/.vite/build"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.yarn
              pkgs.unzip
              asarFromYarn
              extractCodex
            ];

            shellHook = ''
              echo "Run 'extract-codex' to unpack Codex.app and app.asar into ./scratch."
              echo "The 'asar' CLI is available from a fetchYarnDeps-based Nix package."
            '';
          };
        }
      );
    };
}
