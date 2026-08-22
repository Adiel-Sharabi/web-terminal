// MSVC STL forward-compatibility shim — WEB-TERMINAL PATCH (#158)
//
// WHY THIS FILE EXISTS
// --------------------
// `flutter build windows --release` failed to link:
//
//     LNK2019: unresolved external symbol __std_find_first_of_trivial_pos_1
//              referenced in flatbuffers.dir_Release_idl_parser.obj
//              (inside firebase_app.lib)
//     LNK1120: 1 unresolved external
//
// `__std_find_first_of_trivial_pos_1` is an INTERNAL MSVC STL helper — the
// vectorised back end of `std::string::find_first_of`. It was added in MSVC
// Build Tools **14.51**, which ships with the **VS 2026** toolset line. It is
// NOT in any VS 2022 update, so "update Visual Studio 2022" does not fix this;
// the installed 14.43.34808 `libcpmt.lib` contains zero occurrences of it
// (verified by grep), while carrying the older `__std_find_trivial_*` family.
//
// Firebase ships PREBUILT Windows libraries. From Firebase C++ SDK 12.7.0 on
// (pinned by firebase_core >= 3.13.0; we are on 4.11.0 -> SDK 13.5.0) those
// binaries were compiled with a >= 14.51 toolset, so they call helpers our
// toolset does not provide. Upstream: flutterfire#17270 reports the same
// symbol family.
//
// WHY A SHIM RATHER THAN A DOWNGRADE
// ----------------------------------
// The only firebase_core still pinning a linkable SDK (12.0.0) is 3.12.1 —
// a ~16-month, major-version regression across five coupled packages
// (firebase_core, firebase_messaging and three platform-interface/web
// packages), all needing hard pins so `pub upgrade` cannot walk forward. That
// trades a year of Android push security fixes for a Windows link error.
//
// And Windows NEVER USES FIREBASE AT ALL: `main.dart` gates
// `Firebase.initializeApp()` behind `pushSupported`
// (`Platform.isAndroid || Platform.isIOS`). firebase_core merely REGISTERS as
// a Windows plugin, which is enough to drag firebase_app.lib into the link.
// The defect is a native-link artifact of a feature this platform never runs,
// so the fix belongs at the link step — not in the dependency graph.
//
// WHY IT CANNOT ROT INTO A DUPLICATE-SYMBOL FAILURE
// -------------------------------------------------
// The obvious form of this fix — defining `__std_find_first_of_trivial_pos_1`
// directly — is a LANDMINE. The real symbol lives in `vector_algorithms.obj`
// inside `libcpmt.lib`, alongside helpers this build already pulls in, so the
// day the toolset gains it the linker would see two definitions and fail with
// LNK2005. The fix would break the build it was written to fix.
//
// `/ALTERNATENAME` avoids that by construction: it substitutes our symbol ONLY
// while the real one is unresolved. Install a toolset that provides it and the
// real vectorised implementation wins, this file becomes inert, and nothing
// needs editing. Delete it only once the minimum supported toolset is >= 14.51.
//
// THE ABI IS PROVEN, NOT RECALLED
// -------------------------------
// A wrong signature here corrupts memory silently, so the contract was
// established by disassembling the real call sites in idl_parser.obj rather
// than from memory. Two independent paths agree:
//
//   1. `std::_Find_first_of_pos_vectorized<char,char>` is a zero-instruction
//      tail-call thunk (`jmp __std_find_first_of_trivial_pos_1`) whose own
//      signature dumpbin demangles as
//      `(char const* const, unsigned __int64, char const* const, unsigned __int64)`
//      — count-based, printed by the tool, not inferred.
//
//   2. In `basic_string::find_first_of`, RDX is produced by `sub rdx,r15`
//      (`size - pos`) — SCALAR arithmetic on two counts. The end pointer IS
//      computed (`lea rsi,[rdx+rbp]`) but never reaches an argument register;
//      it feeds only the short-input scalar fallback. So the parameters are
//      (ptr, count, ptr, count), NOT a pair of iterator ranges.
//
// Return contract, from the same call site: `cmp rax,0FFFFFFFFFFFFFFFFh` then
// `lea rcx,[r15+rax]` / `cmove rcx,rax` — the caller adds the original `pos`
// back on the found path and propagates the sentinel unchanged. So the result
// is a 0-based index RELATIVE TO first1, or SIZE_MAX for not-found.
//
// Two edge cases the disassembly could not exercise, because the caller guards
// both before calling: count1 == 0 (`pos < size` is checked) and count2 == 0
// (empty needle is special-cased). The loops below handle each by falling
// through to the not-found sentinel and never dereference a pointer whose
// count is zero, which is the conservative reading of find_first_of's contract.

#include <cstddef>

extern "C" std::size_t wt_stl_find_first_of_trivial_pos_1(
    const char* first1, std::size_t count1,
    const char* first2, std::size_t count2) noexcept {
  for (std::size_t i = 0; i < count1; ++i) {
    const char needle = first1[i];
    for (std::size_t j = 0; j < count2; ++j) {
      if (needle == first2[j]) {
        return i;
      }
    }
  }
  return static_cast<std::size_t>(-1);
}

#pragma comment( \
    linker,      \
    "/ALTERNATENAME:__std_find_first_of_trivial_pos_1=wt_stl_find_first_of_trivial_pos_1")
