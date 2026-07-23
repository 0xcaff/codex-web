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
    version = "0.146.0-alpha.3";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-Gq7mT+Hw+HRaI36XcM9LVIfUJDztdntH0Ihogj9uJnA=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-8pLytGoMCvLO9Hu7v4iDRm9gSKwCBcAEHvgj+4E3+7U=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-elV4T/xTrVLRBk0grPAIEEnQOcWnYvVDSL7pQkhGkeQ=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-Z2/5G+qcX/HrDxe0NIRhYtikFOGCApZlNO+jVwcwQ4k=";
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
