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
    version = "0.126.0-alpha.8";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-aAlnzgJ8CSfBjnY0xzky5Ng0N+hh9ltHWG88rJCOl4s=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-2ixnJ3wbBYSP+Bqf2vk0Fr3wkFrVl1eHzLHyppFQBmM=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-Gy+o6G7xfsOPsisDnvmVZouj3vpAOBE4n2o7tSiixLs=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-KVX/Pxq0NElDDm02DtCMLulESsL899YbtECMBZtf+8A=";
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
      pkgs.runCommand "codex-app-server-${version}"
        {
          pname = "codex-app-server";
          inherit src version;
          meta.mainProgram = "codex";
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/codex/codex "$out/bin/codex"
        '';
  }
)
