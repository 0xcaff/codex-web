{
  self,
  flake-utils,
  nixpkgs,
  treefmt-nix,
  ...
}:
flake-utils.lib.eachDefaultSystem (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    treefmtEval = treefmt-nix.lib.evalModule pkgs {
      projectRootFile = "flake.nix";
      programs.black.enable = true;
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
