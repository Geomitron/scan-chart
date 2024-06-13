---
"scan-chart": major
---

Full rewrite of chart parsing and issue detection, adding missing functionality and fixing many bugs. Added a more sophisticated track hashing algorithm, which is designed to uniquely identify the features of the chart that impact difficulty and scoring, and ignore any other changes, which makes it suitable for use with leaderboards. Clone Hero's leaderboards use this same system. The scope of this package has also been limited to just expose functions that parse a single chart file. This allows the package to run in both Node.js and Browser contexts.
