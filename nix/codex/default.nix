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
    version = "0.153.3";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-V3nogYxa16LhkmxEbgMZ11uVMzJ/MoNjXc/CvZGeL/4=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-jBRhznDq8w5z2/l8s0SC7XFEGetUB3Y53n/EW6RW9JA=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-yRnALjF9HTM9r2ofNlK6JLSkFTRGNqUzklXbmjZFSwc=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-UFktUtFpRhX5zPPKUEMrtFIal8vJOqLDl2j6ZZ24FbU=";
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
          install -Dm755 package/vendor/*/bin/codex "$out/bin/codex"
          install -Dm755 package/vendor/*/bin/codex-code-mode-host "$out/bin/codex-code-mode-host"
        '';
  }
)
