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
          src = pkgs.fetchurl {
            url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-26.409.20454.zip";
            hash = "sha256-J1xOgVwwXWIcU80Nwqg3xhQxQLHuuDPjpTGlhU2SybQ=";
          };
        in
        {
          default = pkgs.mkShell {
            HOSTED_CODEX_APP_ZIP = src;

            packages = [
              pkgs.nodejs
              pkgs.yarn
              pkgs.unzip
              pkgs.patch
            ];
          };
        }
      );
    };
}
