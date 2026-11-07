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
    version = "0.162.0-alpha.17.2";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-SOCqR4SXVhIPzoWaSDJDQ77sGR61McUQ7JU2+Ter4sM=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-ooaJutFVxCze/gzbF2V+bim0q7RwKWBNN2/39gEvjIs=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-Is/979IeoYfOhly9BPY/5wUYRJWVuNxKOeViYPUlP3I=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-ByvQXkSpV1I/E/McAc+AWnl6UR7FaFUCbe6SbSupd/0=";
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
