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
    version = "0.126.0-alpha.15";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-/U3Hio/m1An1S7H31k1uAqU7HW7JiceTucks8Lyg8/k=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-396lxjGi625YY3P0z3B9BSg2Umwn65WZ8dGcRqXbZR8=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-VCIHy5xuZgE7Zpk4Eg8TiZZIoBJSpqlzTTZski2BJTY=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-O5NXigt3Z+bE0a8ivUb1zIKGA261VgPp1YOAw8HskQ4=";
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
