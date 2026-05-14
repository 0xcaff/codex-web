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
    version = "0.131.0-alpha.9";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-wUuans8qSISGW2tNXZBiEYL22X1qKSdvq8HD3WQtHEk=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-fuE3xe0Z1rJ3+8b86yZJckyImXftqXsJAxXsj/szZig=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-WUjSGScE00q4YfdLLlHDW4ekYRcEhWvCX4eAytVtemU=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-GSIUcJhlsNeqETh17af5s3xa01LVkWVW2GQH6P2WtLo=";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = platform.hash;
    };
  in
  {
    packages.codex =
      pkgs.runCommand "codex-${version}"
        {
          pname = "codex";
          inherit src version;
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/codex/codex "$out/bin/codex"
        '';
  }
)
