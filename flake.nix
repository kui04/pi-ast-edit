{
  description = "pi-ast-edit: ast-grep powered code editing for pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" ];
        };
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            type != "directory"
            || !(builtins.elem (baseNameOf path) [
              "target"
              "node_modules"
              "result"
            ]);
        };
        # Dynamic glibc build (dev / local use).
        piAstEdit = pkgs.rustPlatform.buildRustPackage {
          pname = "pi-ast-edit";
          version = "0.1.0";
          inherit src;
          cargoLock.lockFile = ./Cargo.lock;
        };
        # Fully static musl build (release binaries for Linux).
        piAstEditStatic = pkgs.pkgsStatic.rustPlatform.buildRustPackage {
          pname = "pi-ast-edit";
          version = "0.1.0";
          inherit src;
          cargoLock.lockFile = ./Cargo.lock;
        };
      in
      {
        packages.default = piAstEdit;
        packages.pi-ast-edit = piAstEdit;
        packages.pi-ast-edit-static = piAstEditStatic;

        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.nodejs
            pkgs.gcc # tree-sitter grammars are compiled with cc
          ];
        };
      }
    );
}
