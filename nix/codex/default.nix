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
    version = "0.133.0-alpha.1";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-AoBexHTMnNWO2+3Z3fekiLIcsr51e434khvgFHQ+P5U=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-oL7Tq8pqppbbOHVbdP2co48BLBJx21CvDH5KAifDeKs=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-rI1S/Okx15TBCUzSs0GNbV+VtZobsHh+sKTArWgF6SM=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-Wid3ZdMzb45vqNzuFtSV6LXnkDm7z/xk7xDvdresa2k=";
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
