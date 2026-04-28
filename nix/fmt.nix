{
  self,
  flake-utils,
  nixpkgs,
  treefmt-nix,
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
    treefmtEval = treefmt-nix.lib.evalModule pkgs {
      projectRootFile = "flake.nix";
      settings.excludes = [ "nix/codex/Cargo.nix" ];
      programs.nixfmt.enable = true;
    };
  in
  {
    formatter = treefmtEval.config.build.wrapper;

    checks = {
      formatting = treefmtEval.config.build.check self;
    };
  }
)
