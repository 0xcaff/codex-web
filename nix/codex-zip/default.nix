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
    version = "26.707.30751";
  in
  {
    packages.codexZip = pkgs.fetchurl {
      name = "chatgpt-darwin-arm64-${version}.zip";
      url = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${version}.zip";
      hash = "sha256-+BAjhFrlbruYs0nkvIHXtJBTNWSJfOoOpPxKFxBPOJI=";
      passthru = {
        inherit version;
      };
    };
  }
)
