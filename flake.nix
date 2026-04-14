{
  description = "codex-hosted dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    {
      self,
      flake-utils,
      nixpkgs,
      treefmt-nix,
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
        nodeSources = pkgs.srcOnly pkgs.nodejs;
        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
        };
        codexZip = pkgs.fetchurl {
          url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-26.409.20454.zip";
          hash = "sha256-J1xOgVwwXWIcU80Nwqg3xhQxQLHuuDPjpTGlhU2SybQ=";
        };
      in
      {
        formatter = treefmtEval.config.build.wrapper;

        checks = {
          formatting = treefmtEval.config.build.check self;
        };

        devShells.default = pkgs.mkShell {
          HOSTED_CODEX_APP_ZIP = codexZip;

          packages = [
            pkgs.nodejs
            pkgs.yarn
            pkgs.unzip
            pkgs.patch
          ];
        };

        packages.default = pkgs.stdenv.mkDerivation {
          HOSTED_CODEX_APP_ZIP = codexZip;

          pname = "codex-hosted";
          version = "1.0.0";
          src = ./.;

          yarnOfflineCache = pkgs.fetchYarnDeps {
            yarnLock = ./yarn.lock;
            hash = "sha256-uvt9oiCu33rY3UuKEghOw5RvuJLpHy4Xqkp1Eexe2J0=";
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

        packages.codex_remote_proxy = pkgs.stdenvNoCC.mkDerivation {
          pname = "codex-remote-proxy";
          version = "1.0.0";
          src = ./.;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin"
            cp scripts/codex_remote_proxy "$out/bin/codex_remote_proxy"
            chmod +x "$out/bin/codex_remote_proxy"

            wrapProgram "$out/bin/codex_remote_proxy" \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.bash
                  pkgs.coreutils
                  pkgs.websocat
                ]
              }

            runHook postInstall
          '';
        };
      }
    );
}
