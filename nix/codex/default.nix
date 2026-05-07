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
    version = "0.129.0-alpha.15";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-ooXq+LOupw37NzPVCvLlLZH9WhhlGHjg9vnzjmjilgs=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-A0HuNRLL7MsS0GFzVx632erk5ERPoZh+gQdsRbr01Tc=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-ySlxQ9H16fI2iWFm2DaDTHRcwlsxYJXlxPjxkM7zqOs=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-ZF5xv3mC5wmZnW73CzucNa+4fAC85dvhlmq+/h1TLZ0=";
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
