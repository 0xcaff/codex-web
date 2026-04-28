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
    version = "0.121.0";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-b4nKBz3zlOJ6t8UpWkmxNSvBz/jcOdlUkc8Biif7apM=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-aGRWd2MZSizB9IgKi6FcT332R3qMVqpQ9oX1J1msg8k=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-ME+c/vsjRdDxulUUzUIeK/a+GYWxs7qxg/uXPezk5yA=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-suRePMCtRmK+csvAwNAdMDwbHbfvbIYlZt5rSoGk7yU=";
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
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/codex/codex "$out/bin/codex"
        '';
  }
)
