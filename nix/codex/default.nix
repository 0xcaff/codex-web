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
    version = "0.167.0-alpha.3.2";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-OyDl5IM/Rl76Uzal1fBWjcNzhSSsg30Lvu7prOmVmBw=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-ay/D7QkXJwdOXZe2PN4zQ1XiEkOpyss5cnm6v8vWq8w=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-XMNY7//P7JHyykltaAX0Hslu4c8HleTRYnQynj7Uj94=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-awPLOtf3x+dEvX4JBGGuBZhgvHS0MTjVkz56j9OizM4=";
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
          # Keep the package metadata and bundled resources beside bin for discovery.
          mkdir -p "$out"
          cp -R package/vendor/*/. "$out/"
        '';
  }
)
