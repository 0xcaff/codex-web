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
    version = "0.130.0-alpha.5";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-fB7PuADZasjSnakh/o+QCUsCIMauuZLY0b7DilFf5xU=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-y1PAKwWeccKbhEBAwVRopoKZ4TTLX2TqJSymcvBDI5k=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-PBge7say/j726O7esbK/+YnBKa1i3UCPV2MTG8lE6f4=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-jzqwvew+ke4C+nKT1OrpBDClhppCZeheWpZRwLrubVg=";
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
