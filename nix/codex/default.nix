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
    version = "0.144.0-alpha.4";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-y77uJWKhP/6hgziwjBiQXRpWuB8hfpi6rhcH6O6+/bs=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-nz/B9Gqnc/bWY+7NO4jHU/SGIIJtlFgwwaaofbyctcs=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-nxFVEkzHTgUiON6N9jYa2FBfVcL76xjS6XZU+90wt60=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-Tas4KCEn+Qcc8TCVYV1Gjwob/02Ho9px0ezbWWMj7d8=";
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
