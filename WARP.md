# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Common Commands

### Setup and Build
```bash
# Prerequisites: Rust toolchain and Python 3.9+
rustup install stable
python -m venv venv && source venv/bin/activate  # or your preferred venv method

# Development install (editable)
pip install -U pip wheel build setuptools-rust
pip install -e .

# Install optional dependencies
pip install .[blobfile]  # for blobfile support
```

### Testing
```bash
# Install test dependencies
pip install pytest hypothesis

# Run all tests
pytest

# Quick test of specific functionality
pytest tests/test_encoding.py::test_simple -q

# Sanity check
python -c "import tiktoken; e=tiktoken.get_encoding('cl100k_base'); print(e.encode('hello world'))"
```

### Building Distributions
```bash
# Build wheel and source distribution
python -m build

# For cross-compilation on macOS
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

## Architecture Overview

tiktoken is a hybrid Python/Rust library for fast BPE tokenization used by OpenAI models.

**Core Components:**
- `tiktoken/core.py`: `Encoding` class - Python wrapper around Rust implementation
- `src/lib.rs` + `src/py.rs`: Rust `CoreBPE` - performance-critical BPE implementation
- `tiktoken/registry.py`: Dynamic loading and caching of encodings
- `tiktoken/model.py`: Model name → encoding name mapping
- `tiktoken_ext/`: Namespace package for encoding definitions

**Data Flow:**
1. User calls `tiktoken.get_encoding(name)` or `tiktoken.encoding_for_model(model)`
2. Registry loads encoding constructor from `tiktoken_ext.*` plugins
3. Creates `Encoding` object with pattern, mergeable ranks, and special tokens
4. `Encoding` delegates actual tokenization to Rust `CoreBPE` via `_tiktoken` extension
5. Python layer handles special token validation and Unicode edge cases

## Python-Rust Boundary

**Rust Crate Configuration:**
- Type: `cdylib` + `rlib` with PyO3 bindings
- Feature flag: `python` enables PyO3 extension module
- Key dependencies: `fancy-regex`, `regex`, `bstr`, `rustc-hash`

**Build System:**
- `setuptools-rust` compiles `tiktoken._tiktoken` extension
- Release mode always enabled (`debug=False`)
- CI uses `cibuildwheel` for multi-platform wheels

**Key Methods Bridge:**
- `encode_ordinary()`: Fast path, no special tokens
- `encode()`: Handles special token logic
- `encode_to_tiktoken_buffer()`: Returns raw buffer for numpy conversion
- Python repairs Unicode surrogates before passing to Rust

## Development Workflow

**Typical Iteration:**
1. Make changes to Python or Rust code
2. Reinstall: `pip install -e .`
3. Run tests: `pytest tests/test_encoding.py -q`
4. Verify: `python -c "import tiktoken; print(tiktoken.__version__)"`

**Testing Patterns:**
- Property-based tests with `hypothesis` verify encode/decode roundtrips
- Special token tests ensure safety (raises by default on special token text)
- Edge case tests for catastrophic repetition scenarios
- CI runs `pytest {project}/tests --import-mode=append`

## Tokenization Model

**BPE Properties:**
- Reversible, lossless text ↔ token conversion
- Works on arbitrary text (even outside training data)
- ~4 bytes per token compression ratio
- Merges common subwords for better generalization

**Special Tokens:**
- Require explicit `allowed_special` parameter or use `encode_ordinary()`
- Default behavior: raises `ValueError` on special token text
- Use `allowed_special="all"` to allow all special tokens

## Extending tiktoken

**Option 1: Direct Construction**
```python
import tiktoken
enc = tiktoken.Encoding(
    name="my_encoding",
    pat_str=base_encoding._pat_str,
    mergeable_ranks=my_ranks,
    special_tokens=my_special_tokens
)
```

**Option 2: Plugin Registration**
Create namespace package under `tiktoken_ext/`:
```
my_extension/
├── tiktoken_ext/
│   └── my_encodings.py  # Define ENCODING_CONSTRUCTORS dict
└── setup.py              # Use find_namespace_packages
```

Install normally (not editable): `pip install ./my_extension`

## Model Mapping

Defined in `tiktoken/model.py`:
- **Direct mappings**: `gpt-4` → `cl100k_base`, `gpt-4o` → `o200k_base`
- **Prefix mappings**: `gpt-4o-*` → `o200k_base`, `gpt-3.5-turbo-*` → `cl100k_base`
- **Usage**: Prefer `encoding_for_model()` when possible

## Key Considerations

- **Special Token Safety**: `encode()` raises on special tokens by default; use `encode_ordinary()` or set `allowed_special`
- **Unicode Handling**: Surrogates are repaired in Python before Rust processing
- **Performance**: Use batch methods (`encode_batch()`) for multiple strings
- **Large Inputs**: Some encodings have repetition limits (e.g., 1M chars for `o200k_base`)
- **Numpy**: `encode_to_numpy()` requires numpy at runtime (lazy import)
- **Vocab Validation**: `explicit_n_vocab` parameter enforces vocab size consistency

## Version Information

Current versions (check for updates):
- Python package: 0.11.0
- Rust crate: 0.11.0
- Minimum Python: 3.9
- Rust edition: 2024
