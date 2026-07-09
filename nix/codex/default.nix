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
    version = "0.142.5";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-UfjbUXuToIbovKehCMrIGjE6buvPszNsoQW65J8Rd2w=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-8+8J7T5fMUCIghAQmnJeBQKSKzTaGKndAMVYHVAV1Pk=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-fsy6iZbom0h/6lKPTDe/UPDAoviSg2Z+aydKXnGbDUY=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-oD4xFssJCa67Az45zUAYs6Ha+dSJYxk5thY/+pB63kc=";
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
        '';
  }
)
