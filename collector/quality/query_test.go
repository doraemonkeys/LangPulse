package quality

import "testing"

func TestBuildSearchQueryOmitsStarsForZeroThreshold(t *testing.T) {
	query := BuildSearchQuery(
		SnapshotWindowDays,
		Language{GitHubQueryFragment: `language:"go"`},
		Threshold{Value: 0},
		mustParseDay(t, "2026-04-07"),
	)

	want := `language:"go" is:public fork:true pushed:>=2026-03-09`
	if query != want {
		t.Fatalf("BuildSearchQuery() = %q, want %q", query, want)
	}
}

func TestBuildSearchQueryIncludesStarsQualifier(t *testing.T) {
	query := BuildSearchQuery(
		SnapshotWindowDays,
		Language{GitHubQueryFragment: `language:"Protocol Buffers"`},
		Threshold{Value: 10},
		mustParseDay(t, "2026-04-07"),
	)

	want := `language:"Protocol Buffers" is:public fork:true pushed:>=2026-03-09 stars:>=10`
	if query != want {
		t.Fatalf("BuildSearchQuery() = %q, want %q", query, want)
	}
}

func TestBuildSearchQueryPreservesConfiguredQueryFragments(t *testing.T) {
	query := BuildSearchQuery(
		SnapshotWindowDays,
		Language{GitHubQueryFragment: `language:"Visual Basic .NET"`},
		Threshold{Value: 100},
		mustParseDay(t, "2026-04-07"),
	)

	want := `language:"Visual Basic .NET" is:public fork:true pushed:>=2026-03-09 stars:>=100`
	if query != want {
		t.Fatalf("BuildSearchQuery() = %q, want %q", query, want)
	}
}

func TestBuildSearchQueryPreservesSpecialCharacterFragments(t *testing.T) {
	query := BuildSearchQuery(
		SnapshotWindowDays,
		Language{GitHubQueryFragment: `language:"c#"`},
		Threshold{Value: 0},
		mustParseDay(t, "2026-04-07"),
	)

	want := `language:"c#" is:public fork:true pushed:>=2026-03-09`
	if query != want {
		t.Fatalf("BuildSearchQuery() = %q, want %q", query, want)
	}
}
