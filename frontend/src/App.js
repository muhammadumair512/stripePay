// frontend/src/App.js

import React, { useState } from "react";
import axios from "axios";

function App() {
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setIsLoading(true);

    // Basic validation
    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10);
    if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
      setMessage("Please enter a valid year and month (1-12).");
      setIsLoading(false);
      return;
    }

    try {
      const response = await axios.post("/api/generate-pdf", {
        year,
        month,
        email,
      });

      if (response.status === 200) {
        setMessage("All data is sent to admin email.");
      } else {
        setMessage("An error occurred. Please try again.");
      }
    } catch (error) {
      console.error("Error:", error);
      setMessage("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <h1>Generate Invoices</h1>
      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.label}>
          Year:
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            required
            style={styles.input}
            min="2000"
            max="2100"
          />
        </label>
        <label style={styles.label}>
          Month:
          <input
            type="number"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            required
            style={styles.input}
            min="1"
            max="12"
          />
        </label>
        <label style={styles.label}>
          Your Email:
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={styles.input}
          />
        </label>
        <button type="submit" style={styles.button} disabled={isLoading}>
          {isLoading ? "Processing..." : "Submit"}
        </button>
      </form>
      {message && <p style={styles.message}>{message}</p>}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: "400px",
    margin: "50px auto",
    padding: "20px",
    textAlign: "center",
    border: "1px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 4px 8px rgba(0,0,0,0.1)"
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "15px",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    textAlign: "left",
    fontWeight: "bold"
  },
  input: {
    padding: "8px",
    fontSize: "16px",
    marginTop: "5px",
    borderRadius: "4px",
    border: "1px solid #ccc"
  },
  button: {
    padding: "10px",
    fontSize: "16px",
    backgroundColor: "#4CAF50",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer"
  },
  message: {
    marginTop: "20px",
    fontWeight: "bold"
  }
};

export default App;
